import { ownBytes, requireValue, fields, ascii } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, Deadline, sleep, needsSenderRepair } from '@/features/naidan-piping-duplex/finite';
import type { FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingKeyContext, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type PinnedConnectionTask = {
    readonly ready: Promise<NaidanPipingKeyContext>;
    readonly completion: Promise<void>;
};
/** Owns discovery and bounded final-flight retention, not the returned traffic keys. */
export async function startPinnedConnection({ role, identity, expectedPeer, code, endpoint, signal, activeTimeoutMs, completionLeaseMs, intervalMs, purpose, verifyPeer }: {
    role: NaidanPipingRole;
    identity: NaidanPipingIdentity;
    expectedPeer: Uint8Array | undefined;
    verifyPeer?: NaidanPipingPeerVerifier;
    code: string;
    endpoint: FiniteTransport;
    signal: AbortSignal;
    activeTimeoutMs: number | undefined;
    completionLeaseMs: number | undefined;
    intervalMs: number;
    purpose: Uint8Array;
}): Promise<PinnedConnectionTask> {
  for (const value of [activeTimeoutMs, completionLeaseMs, intervalMs])
    requireValue({ condition: value === undefined || (Number.isInteger(value) && value > 0 && value <= 2147483647), message: 'Connection timer duration' });
  const purposeBytes = ownBytes({ bytes: purpose, maxBytes: 256 });
  const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 });
  requireValue({ condition: pin?.length === 32 || (pin === undefined && verifyPeer !== undefined), message: 'Expected pin or explicit peer comparison required' });
  const localIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  signal.throwIfAborted();
  const channel = await RendezvousChannel.create({ role, code, origin: endpoint.origin });
  signal.throwIfAborted();
  const ioStop = new AbortController();
  const forward = () => ioStop.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted)
    forward();
  let resolveReady!: ReturnType<typeof Promise.withResolvers<NaidanPipingKeyContext>>['resolve'];
  let rejectReady!: ReturnType<typeof Promise.withResolvers<NaidanPipingKeyContext>>['reject'];
  const ready = new Promise<NaidanPipingKeyContext>((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  // Readiness and cleanup are intentionally separate promises, both immediately rejection-owned.
  void ready.catch(() => { });
  const fail = ({ reason }: {
        reason: unknown;
    }) => {
    if (!ioStop.signal.aborted)
      ioStop.abort(reason);
  };
  let established = false;
  let finalAdvertised = false;
  // Send the complete final journal at least once before slowing indefinite retention.
  // Explicit finite leases retain their caller-selected cadence; a five-second sleep
  // must not swallow a shorter lease before its first retry.
  const pause = () => established && finalAdvertised && completionLeaseMs === undefined ? Math.max(intervalMs, 5000) : intervalMs;
  const send = async () => {
    while (!ioStop.signal.aborted) {
      try {
        const wasEstablished = established;
        const bytes = channel.snapshot();
        if (bytes) {
          await endpoint.send({ route: channel.routes.send, bytes, signal: ioStop.signal });
          if (wasEstablished) finalAdvertised = true;
        }
      } catch (error) {
        ioStop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal')
          throw error;
        if (needsSenderRepair({ kind: error.kind }))
          await endpoint.repair({ route: channel.routes.send, signal: ioStop.signal });
      }
      await sleep({ milliseconds: pause(), signal: ioStop.signal });
    }
  };
  const receive = async () => {
    while (!ioStop.signal.aborted) {
      try {
        channel.accept({ bytes: await endpoint.receive({ route: channel.routes.receive, signal: ioStop.signal }) });
      } catch (error) {
        ioStop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal')
          throw error;
      }
      await sleep({ milliseconds: pause(), signal: ioStop.signal });
    }
  };
  const guarded = async ({ task }: {
        task: () => Promise<void>;
    }) => {
    try {
      await task();
    } catch (error) {
      fail({ reason: error });
    }
  };
  const jobs = [guarded({ task: send }), guarded({ task: receive })];
  const completion = (async (): Promise<void> => {
    const active = activeTimeoutMs === undefined ? undefined : new Deadline({ parent: ioStop.signal, milliseconds: activeTimeoutMs });
    const activeSignal = active?.signal ?? ioStop.signal;
    try {
      const discoveryBinding = await channel.binding({ signal: activeSignal });
      const binding = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({ parts: [
        ascii({ text: 'naidan-piping-purpose/v1' }), discoveryBinding, purposeBytes,
      ] })));
      const keys = await establishVerifiedNaidanPipingKeys({ role, identity: localIdentity, expectedPeer: pin, verifyPeer, binding, channel, signal: activeSignal });
      if (activeSignal.aborted) {
        keys.dispose();
        activeSignal.throwIfAborted();
      }
      established = true;
      resolveReady(keys);
      active?.dispose();
      // Expiry bounds memory and HTTP ownership. It does not prove the other endpoint completed.
      // Retention is local and bounded. No upper protocol must assert peer activity.
      if (completionLeaseMs === undefined) {
        await new Promise<void>((_resolve, reject) => {
          if (ioStop.signal.aborted) reject(ioStop.signal.reason);
          else ioStop.signal.addEventListener('abort', () => reject(ioStop.signal.reason), { once: true });
        });
      } else await sleep({ milliseconds: completionLeaseMs, signal: ioStop.signal });
    } catch (error) {
      rejectReady(error);
      throw error;
    } finally {
      active?.dispose();
      ioStop.abort();
      await Promise.allSettled(jobs);
      channel.dispose();
      signal.removeEventListener('abort', forward);
    }
  })();
  void completion.catch(() => { });
  return { ready, completion };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
