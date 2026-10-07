import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { LlamaCppBrowserError, type Progress } from '@/features/llama-cpp-browser/types';

type NumericProgress = Omit<Progress, 'phase'> & { phase: 'prefill' | 'generating' };

/** Progress is a replaceable snapshot, not a content delta. Keep at most one
 * callback per phase in flight and one latest unsent snapshot across phases.
 * A phase's first callback starts immediately, even during a native call.
 * Loading/import/audio callbacks deliberately use their existing delivery path. */
export function createProgressQueue({ deliver, signal }: {
  deliver: ({ progress }: { progress: NumericProgress }) => void | Promise<void>,
  signal: AbortSignal,
}) {
  const active = new Map<NumericProgress['phase'], Promise<void>>();
  let pending: NumericProgress | undefined;
  let accepting = true;
  let failed = false;
  const counters = {
    received: 0,
    sent: 0,
    settled: 0,
    coalesced: 0,
    discarded: 0,
    callbackFailures: 0,
    peakInFlight: 0,
    peakPending: 0,
  };
  const discardPending = (): void => {
    if (pending) counters.discarded++;
    pending = undefined;
  };
  const fail = ({ error }: { error: unknown }): void => {
    counters.callbackFailures++;
    failed = true;
    discardPending();
    try {
      logFailure({ stage: 'worker-callback', error });
    } catch { /* Logging must not leave an unobserved callback rejection. */ }
  };
  const start = ({ progress }: { progress: NumericProgress }): void => {
    // Publish ownership before invoking a potentially synchronous/reentrant
    // callback. Resolving this promise also accounts for its entire handler.
    const phase = progress.phase;
    let settle: () => void = () => {};
    const completion = new Promise<void>(resolve => {
      settle = resolve;
    });
    active.set(phase, completion);
    counters.sent++;
    counters.peakInFlight = Math.max(counters.peakInFlight, active.size);
    const complete = (): void => {
      active.delete(phase);
      counters.settled++;
      if (signal.aborted || failed) discardPending();
      const next = pending;
      if (next && !active.has(next.phase)) {
        pending = undefined;
        start({ progress: next });
      }
      settle();
    };
    try {
      // Invoke now, not through a .then(): the first update must be visible
      // before a synchronous native computation returns to the event loop.
      const result = deliver({ progress });
      void Promise.resolve(result).then(complete, error => {
        fail({ error }); complete();
      });
    } catch (error) {
      fail({ error }); complete();
    }
  };
  return {
    counters,
    send({ progress }: { progress: NumericProgress }): void {
      if (!accepting) return;
      counters.received++;
      if (signal.aborted || failed) {
        counters.discarded++;
        discardPending();
        return;
      }
      if (pending) {
        // A new phase supersedes an old phase's undelivered state. Never let
        // a delayed prefill update overwrite a newer generating indicator.
        if (pending.phase === progress.phase) counters.coalesced++;
        else counters.discarded++;
        pending = undefined;
      }
      // Copy the numeric snapshot; callers may reuse their progress object.
      const { phase, completed, total, ...unhandled } = progress;
      unhandled satisfies Record<PropertyKey, never>;
      const snapshot: NumericProgress = { phase, completed, total };
      if (active.has(snapshot.phase)) {
        pending = snapshot;
        counters.peakPending = 1;
      } else start({ progress: snapshot });
    },
    async finish(): Promise<void> {
      accepting = false;
      if (signal.aborted || failed) discardPending();
      // Completing one callback can start delivery of the latest snapshot.
      // A single Promise.all(active) would miss that newly owned callback.
      while (active.size > 0) await Promise.all(active.values());
      if (failed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    },
  };
}

export const TEST_ONLY = {
};
