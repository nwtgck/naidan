import { requireValue } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, Deadline, sleep, needsSenderRepair } from '@/features/naidan-piping-duplex/finite';
import type { FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import type { StreamSession } from '@/features/naidan-piping-duplex/session';
export type RunnerEvent = {
    kind: 'sent' | 'received' | 'repair' | 'retry' | 'unauthenticated';
    count: number;
};
export type NaidanPipingDuplexPacing = {
    minimumMs: number;
    heartbeatMs: number;
    retryBaseMs: number;
    retryMaximumMs: number;
};
export function retryDelay({ failures, baseMs, maximumMs, randomUnit }: {
    failures: number;
    baseMs: number;
    maximumMs: number;
    randomUnit: number;
}): number {
  requireValue({ condition: Number.isSafeInteger(failures) && failures >= 1 && Number.isInteger(baseMs) && baseMs >= 2 &&
            Number.isInteger(maximumMs) && maximumMs >= baseMs && maximumMs <= 2147483647 &&
            Number.isFinite(randomUnit) && randomUnit >= 0 && randomUnit < 1, message: 'Retry delay parameters' });
  const ceiling = Math.min(baseMs * 2 ** Math.min(failures - 1, 31), maximumMs);
  const floor = Math.ceil(ceiling / 2);
  return floor + Math.floor(randomUnit * (ceiling - floor + 1));
}
function jitter(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;
}
export function validatePacing({ pacing }: {
    pacing: NaidanPipingDuplexPacing;
}): void {
  const { minimumMs, heartbeatMs, retryBaseMs, retryMaximumMs, ...rest } = pacing;
    rest satisfies Record<PropertyKey, never>;
    requireValue({ condition: [minimumMs, heartbeatMs, retryBaseMs, retryMaximumMs].every(value => Number.isInteger(value) && value > 0 && value <= 2147483647) &&
            heartbeatMs >= minimumMs && retryBaseMs >= Math.max(2, minimumMs) && retryMaximumMs >= retryBaseMs,
    message: 'Pacing parameters' });
}
export async function runDuplex({ session, endpoint, signal, pacing, onEvent }: {
    session: StreamSession;
    endpoint: FiniteTransport;
    signal: AbortSignal;
    pacing: NaidanPipingDuplexPacing;
    onEvent: ({ event }: {
        event: RunnerEvent;
    }) => void;
}): Promise<void> {
  validatePacing({ pacing });
  const settings = { ...pacing }, release = session.claimTransport();
  const local = new AbortController(), forward = () => local.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted)
    forward();
  const backoff = async ({ failures }: {
        failures: number;
    }) => sleep({
    milliseconds: retryDelay({ failures, baseMs: settings.retryBaseMs, maximumMs: settings.retryMaximumMs, randomUnit: jitter() }), signal: local.signal
  });
  const send = async () => {
    let failures = 0;
    while (!local.signal.aborted && !session.stopped) {
      // Capture before snapshot and I/O so a concurrent ACK or write cannot be lost.
      const revision = session.revision;
      try {
        const capsule = await session.makeCapsule();
        await endpoint.send({ route: session.routes.send, bytes: capsule, signal: local.signal });
        onEvent({ event: { kind: 'sent', count: capsule.length } });
        failures = 0;
      } catch (error) {
        if (local.signal.aborted || session.stopped)
          return;
        if (!(error instanceof AttemptError) || error.kind === 'fatal')
          throw error;
        if (needsSenderRepair({ kind: error.kind })) {
          await endpoint.repair({ route: session.routes.send, signal: local.signal });
          onEvent({ event: { kind: 'repair', count: 1 } });
        }
        onEvent({ event: { kind: 'retry', count: 1 } });
        failures = Math.min(failures + 1, 32);
        await backoff({ failures });
        continue;
      }
      await sleep({ milliseconds: settings.minimumMs, signal: local.signal });
      const heartbeat = new Deadline({ parent: local.signal, milliseconds: settings.heartbeatMs });
      try {
        await session.waitForChange({ revision, signal: heartbeat.signal });
      } catch (error) {
        if (local.signal.aborted)
          throw error;
        if (!heartbeat.signal.aborted)
          throw error;
      } finally {
        heartbeat.dispose();
      }
    }
  };
  const receive = async () => {
    let failures = 0;
    while (!local.signal.aborted && !session.stopped) {
      try {
        const capsule = await endpoint.receive({ route: session.routes.receive, signal: local.signal });
        const outcome = await session.acceptCapsule({ capsule });
        switch (outcome) {
        case 'unauthenticated':
          onEvent({ event: { kind: 'unauthenticated', count: capsule.length } });
          failures = Math.min(failures + 1, 32);
          break;
        case 'accepted': case 'stale':
          onEvent({ event: { kind: 'received', count: capsule.length } });
          failures = 0;
          break;
        default: { const unreachable: never = outcome; throw new Error(`Invalid record outcome: ${unreachable}`); }
        }
        if (failures)
          await backoff({ failures });
        else
          await sleep({ milliseconds: settings.minimumMs, signal: local.signal });
      } catch (error) {
        if (local.signal.aborted || session.stopped)
          return;
        if (!(error instanceof AttemptError) || error.kind === 'fatal')
          throw error;
        onEvent({ event: { kind: 'retry', count: 1 } });
        failures = Math.min(failures + 1, 32);
        await backoff({ failures });
      }
    }
  };
  const guard = async ({ task }: {
        task: () => Promise<void>;
    }) => {
    try {
      await task();
    } finally {
      local.abort();
    }
  };
  const jobs = [guard({ task: send }), guard({ task: receive })];
  try {
    await Promise.all(jobs);
    if (!signal.aborted && session.failureReason) throw session.failureReason;
  } catch (error) {
    if (!signal.aborted) {
      const failure = session.failureReason ?? error;
      session.abort({ reason: 'Transport runner failed' });
      throw failure;
    }
  } finally {
    local.abort();
    await Promise.allSettled(jobs);
    signal.removeEventListener('abort', forward);
    release();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
